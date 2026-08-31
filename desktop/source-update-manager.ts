import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync } from "node:fs";
import { join, resolve } from "node:path";
import { resolveDesktopEnvironment } from "./shell-env.js";
import { resolveCommandInvocation } from "../src/kernel/discovery.js";
import { desktopDevRestartArgumentsFromEnvironment } from "../scripts/desktop-dev-runtime.mjs";

export type DesktopSourceUpdateStage =
  | "unsupported"
  | "idle"
  | "checking"
  | "available"
  | "up-to-date"
  | "blocked"
  | "updating"
  | "restarting"
  | "error";

export interface DesktopSourceUpdateState {
  supported: boolean;
  stage: DesktopSourceUpdateStage;
  busy: boolean;
  updateAvailable: boolean;
  message: string;
  details?: string;
  appRoot: string;
  branch?: string;
  remote?: string;
  remoteRef?: string;
  currentRevision?: string;
  latestRevision?: string;
  ahead?: number;
  behind?: number;
  worktreeDirty?: boolean;
  checkedAt?: string;
  startedAt?: string;
  finishedAt?: string;
  log: string[];
}

interface DesktopSourceUpdateManagerOptions {
  appRoot: string;
  enabled: boolean;
  restartLogPath?: string;
  log(message: string): void;
  onStateChange(state: DesktopSourceUpdateState): void;
  requestQuit(): void;
}

interface GitTarget {
  branch: string;
  remote: string;
  remoteBranch: string;
  remoteRef: string;
}

interface CommandResult {
  stdout: string;
  stderr: string;
}

const MAX_LOG_LINES = 80;

export class DesktopSourceUpdateManager {
  private readonly appRoot: string;
  private readonly enabled: boolean;
  private readonly restartLogPath: string | undefined;
  private readonly logMain: DesktopSourceUpdateManagerOptions["log"];
  private readonly onStateChange: DesktopSourceUpdateManagerOptions["onStateChange"];
  private readonly requestQuit: DesktopSourceUpdateManagerOptions["requestQuit"];
  private readonly supported: boolean;
  private state: DesktopSourceUpdateState;
  private operation?: Promise<DesktopSourceUpdateState>;
  private envPromise?: Promise<NodeJS.ProcessEnv>;

  constructor(options: DesktopSourceUpdateManagerOptions) {
    this.appRoot = resolve(options.appRoot);
    this.enabled = options.enabled;
    this.restartLogPath = options.restartLogPath;
    this.logMain = options.log;
    this.onStateChange = options.onStateChange;
    this.requestQuit = options.requestQuit;
    this.supported = this.enabled && isSourceCheckout(this.appRoot);
    this.state = {
      supported: this.supported,
      stage: this.supported ? "idle" : "unsupported",
      busy: false,
      updateAvailable: false,
      message: this.supported ? "准备检查开发版更新。" : "当前运行环境不是开发源码 checkout。",
      appRoot: this.appRoot,
      log: [],
    };
  }

  snapshot(): DesktopSourceUpdateState {
    return cloneState(this.state);
  }

  checkForUpdates(): Promise<DesktopSourceUpdateState> {
    if (this.operation) return this.operation;
    this.operation = this.runCheck().finally(() => {
      this.operation = undefined;
    });
    return this.operation;
  }

  installUpdate(): Promise<DesktopSourceUpdateState> {
    if (this.operation) return this.operation;
    this.operation = this.runInstall().finally(() => {
      this.operation = undefined;
    });
    return this.operation;
  }

  private async runCheck(): Promise<DesktopSourceUpdateState> {
    if (!this.supported) {
      this.setState({
        stage: "unsupported",
        busy: false,
        updateAvailable: false,
        message: "当前运行环境不是开发源码 checkout。",
      });
      return this.snapshot();
    }

    const previous = this.state;
    this.setState({
      stage: "checking",
      busy: true,
      updateAvailable: previous.updateAvailable,
      message: previous.updateAvailable ? previous.message : "正在检查远端更新...",
      details: previous.updateAvailable ? previous.details : undefined,
      checkedAt: previous.checkedAt,
      log: [],
    });

    try {
      const target = await this.readGitTarget();
      this.appendLog(`git fetch ${target.remote}`);
      await this.runCommand("git", ["fetch", "--quiet", target.remote]);
      const revision = await this.readRevision(target.remoteRef);
      const counts = await this.readAheadBehind(target.remoteRef);
      const dirty = await this.isWorktreeDirty();
      const checkedAt = new Date().toISOString();
      const base = {
        branch: target.branch,
        remote: target.remote,
        remoteRef: target.remoteRef,
        currentRevision: revision.current,
        latestRevision: revision.latest,
        ahead: counts.ahead,
        behind: counts.behind,
        worktreeDirty: dirty,
        checkedAt,
      };

      if (counts.behind > 0 && counts.ahead === 0) {
        this.setState({
          ...base,
          stage: dirty ? "blocked" : "available",
          busy: false,
          updateAvailable: true,
          message: dirty
            ? `发现 ${counts.behind} 个远端更新，但本地有未提交改动。`
            : `发现 ${counts.behind} 个远端更新。`,
          details: dirty ? "请先提交或处理本地改动，再安装更新。" : undefined,
        });
        return this.snapshot();
      }

      if (counts.behind > 0 && counts.ahead > 0) {
        this.setState({
          ...base,
          stage: "blocked",
          busy: false,
          updateAvailable: false,
          message: "远端和本地都有新提交，无法自动 fast-forward。",
          details: "请手动处理分叉后再使用开发版自动更新。",
        });
        return this.snapshot();
      }

      if (counts.ahead > 0) {
        this.setState({
          ...base,
          stage: "blocked",
          busy: false,
          updateAvailable: false,
          message: `本地领先 ${counts.ahead} 个提交，自动更新已暂停。`,
          details: "请确认这些本地提交已经推送或切回可 fast-forward 的分支。",
        });
        return this.snapshot();
      }

      this.setState({
        ...base,
        stage: "up-to-date",
        busy: false,
        updateAvailable: false,
        message: "已经是最新开发版。",
        details: dirty ? "本地仍有未提交改动；这不会影响当前版本判断。" : undefined,
      });
      return this.snapshot();
    } catch (error) {
      this.setError("检查更新失败。", error);
      return this.snapshot();
    }
  }

  private async runInstall(): Promise<DesktopSourceUpdateState> {
    if (!this.supported) {
      this.setState({
        stage: "unsupported",
        busy: false,
        updateAvailable: false,
        message: "当前运行环境不是开发源码 checkout。",
      });
      return this.snapshot();
    }

    try {
      const target = await this.readGitTarget();
      this.setState({
        stage: "checking",
        busy: true,
        updateAvailable: false,
        message: "正在确认是否可以安装更新...",
        details: undefined,
        startedAt: new Date().toISOString(),
      });
      await this.runCommand("git", ["fetch", "--quiet", target.remote]);
      const counts = await this.readAheadBehind(target.remoteRef);
      const dirty = await this.isWorktreeDirty();

      if (dirty) {
        this.setState({
          stage: "blocked",
          busy: false,
          updateAvailable: counts.behind > 0 && counts.ahead === 0,
          message: "本地有未提交改动，已停止安装更新。",
          details: "请先提交或处理本地改动，避免自动更新覆盖你的工作。",
          worktreeDirty: true,
          finishedAt: new Date().toISOString(),
        });
        return this.snapshot();
      }

      if (counts.behind <= 0 || counts.ahead > 0) {
        await this.runCheck();
        return this.snapshot();
      }

      this.setState({
        stage: "updating",
        busy: true,
        updateAvailable: false,
        message: "正在拉取更新...",
        branch: target.branch,
        remote: target.remote,
        remoteRef: target.remoteRef,
      });
      await this.runCommand("git", ["pull", "--ff-only", target.remote, target.remoteBranch]);

      await this.runBuildStep("npm install", ["install"]);
      await this.runBuildStep("npm run build", ["run", "build"]);

      this.setState({
        stage: "restarting",
        busy: true,
        updateAvailable: false,
        message: "更新已安装，正在重启 OpenGrove Dev...",
        finishedAt: new Date().toISOString(),
      });
      await this.launchRestartHelper();
      setTimeout(() => this.requestQuit(), 250);
      return this.snapshot();
    } catch (error) {
      this.setError("安装更新失败。", error);
      return this.snapshot();
    }
  }

  private async readGitTarget(): Promise<GitTarget> {
    const branch = (await this.runCommand("git", ["branch", "--show-current"])).stdout.trim();
    if (!branch) {
      throw new Error("当前是 detached HEAD，开发版自动更新需要在普通分支上运行。");
    }
    const remote = (await this.optionalGitConfig(`branch.${branch}.remote`)) || "origin";
    const merge = (await this.optionalGitConfig(`branch.${branch}.merge`)) || `refs/heads/${branch}`;
    const remoteBranch = merge.replace(/^refs\/heads\//, "");
    if (!remoteBranch) {
      throw new Error(`无法识别 ${branch} 的 upstream 分支。`);
    }
    return {
      branch,
      remote,
      remoteBranch,
      remoteRef: `${remote}/${remoteBranch}`,
    };
  }

  private async optionalGitConfig(key: string): Promise<string> {
    try {
      return (await this.runCommand("git", ["config", "--get", key])).stdout.trim();
    } catch {
      return "";
    }
  }

  private async readRevision(remoteRef: string): Promise<{ current: string; latest: string }> {
    const current = (await this.runCommand("git", ["rev-parse", "HEAD"])).stdout.trim();
    const latest = (await this.runCommand("git", ["rev-parse", remoteRef])).stdout.trim();
    return { current, latest };
  }

  private async readAheadBehind(remoteRef: string): Promise<{ ahead: number; behind: number }> {
    const result = await this.runCommand("git", ["rev-list", "--left-right", "--count", `HEAD...${remoteRef}`]);
    const [aheadText, behindText] = result.stdout.trim().split(/\s+/);
    const ahead = Number(aheadText);
    const behind = Number(behindText);
    if (!Number.isInteger(ahead) || !Number.isInteger(behind)) {
      throw new Error(`无法解析 git ahead/behind: ${result.stdout.trim()}`);
    }
    return { ahead, behind };
  }

  private async isWorktreeDirty(): Promise<boolean> {
    const result = await this.runCommand("git", ["status", "--porcelain"]);
    return result.stdout.trim().length > 0;
  }

  private async runBuildStep(label: string, args: string[]): Promise<void> {
    this.setState({
      stage: "updating",
      busy: true,
      updateAvailable: false,
      message: `正在执行 ${label}...`,
    });
    await this.runCommand("npm", args);
  }

  private async launchRestartHelper(): Promise<void> {
    const env = await this.commandEnv();
    const restartArgs = desktopDevRestartArgumentsFromEnvironment(env);
    this.appendLog(`node ${restartArgs.join(" ")}`);
    if (this.restartLogPath) {
      this.appendLog(`restart log: ${this.restartLogPath}`);
    }
    let stdoutFd: number | undefined;
    let stderrFd: number | undefined;
    let stdio: "ignore" | ["ignore", number, number] = "ignore";
    if (this.restartLogPath) {
      try {
        stdoutFd = openSync(this.restartLogPath, "a");
        stderrFd = openSync(this.restartLogPath, "a");
        stdio = ["ignore", stdoutFd, stderrFd];
      } catch (error) {
        const details = error instanceof Error ? error.message : String(error);
        this.logMain(`source update restart log unavailable: ${details}`);
      }
    }
    const child = (() => {
      try {
        return spawn(process.execPath, restartArgs, {
          cwd: this.appRoot,
          detached: true,
          env: {
            ...env,
            ELECTRON_RUN_AS_NODE: "1",
            OPENGROVE_RESTART_PARENT_PID: String(process.pid),
          },
          stdio,
        });
      } finally {
        if (stdoutFd !== undefined) closeSync(stdoutFd);
        if (stderrFd !== undefined) closeSync(stderrFd);
      }
    })();
    child.unref();
  }

  private async runCommand(command: string, args: string[]): Promise<CommandResult> {
    const env = await this.commandEnv();
    const display = [command, ...args].join(" ");
    this.logMain(`source update command: ${display}`);
    const invocation = resolveCommandInvocation(command, args, { environment: env });
    return new Promise((resolveCommand, rejectCommand) => {
      const child = spawn(invocation.command, invocation.args, {
        cwd: this.appRoot,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        stdout += text;
        this.appendLogLines(text);
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        stderr += text;
        this.appendLogLines(text);
      });
      child.once("error", rejectCommand);
      child.once("exit", (code, signal) => {
        if (code === 0) {
          resolveCommand({ stdout, stderr });
          return;
        }
        const output = (stderr || stdout).trim();
        rejectCommand(new Error(`${display} failed: ${code ?? signal ?? "unknown"}${output ? `\n${output}` : ""}`));
      });
    });
  }

  private async commandEnv(): Promise<NodeJS.ProcessEnv> {
    this.envPromise ??= resolveDesktopEnvironment(process.env);
    return this.envPromise;
  }

  private appendLog(value: string): void {
    this.appendLogLines(`${value}\n`);
  }

  private appendLogLines(value: string): void {
    const lines = value
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .filter(Boolean);
    if (!lines.length) return;
    this.setState({
      log: [...this.state.log, ...lines].slice(-MAX_LOG_LINES),
    });
  }

  private setError(message: string, error: unknown): void {
    const details = error instanceof Error ? error.message : String(error);
    this.setState({
      stage: "error",
      busy: false,
      updateAvailable: false,
      message,
      details,
      finishedAt: new Date().toISOString(),
    });
    this.logMain(`source update error: ${details}`);
  }

  private setState(patch: Partial<DesktopSourceUpdateState>): void {
    this.state = {
      ...this.state,
      ...patch,
      log: patch.log ?? this.state.log,
    };
    this.onStateChange(this.snapshot());
  }
}

function isSourceCheckout(appRoot: string): boolean {
  return (
    existsSync(join(appRoot, ".git")) && existsSync(join(appRoot, "src")) && existsSync(join(appRoot, "package.json"))
  );
}

function cloneState(state: DesktopSourceUpdateState): DesktopSourceUpdateState {
  return {
    ...state,
    log: [...state.log],
  };
}
