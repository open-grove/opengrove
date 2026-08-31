import { BrowserWindow, app, session } from "electron";
import { registerDesktopProtocol, registerDesktopProtocolPrivileges } from "../../desktop/protocol.js";
import { installDesktopProtocolRequestAuthentication } from "../../desktop/security-policy.js";

interface SmokeCompletion {
  statusCode: number;
  url: string;
}

const smokeApp = app as typeof app & {
  __opengroveProtocolSmokeCompletions?: SmokeCompletion[];
};

registerDesktopProtocolPrivileges();
app.setPath("userData", requiredEnvironment("OPENGROVE_SMOKE_USER_DATA"));

let mainWindow: BrowserWindow | undefined;

void app
  .whenReady()
  .then(async () => {
    const bridgeApiBase = requiredEnvironment("OPENGROVE_SMOKE_BRIDGE_API_BASE");
    const bridgeToken = requiredEnvironment("OPENGROVE_SMOKE_BRIDGE_TOKEN");
    const proxyToken = requiredEnvironment("OPENGROVE_SMOKE_PROXY_TOKEN");
    const webRoot = requiredEnvironment("OPENGROVE_SMOKE_WEB_ROOT");
    const completions: SmokeCompletion[] = [];
    smokeApp.__opengroveProtocolSmokeCompletions = completions;

    installDesktopProtocolRequestAuthentication(session.defaultSession, () => proxyToken);
    session.defaultSession.webRequest.onCompleted({ urls: ["opengrove-desktop://ui/api/*"] }, (details) => {
      completions.push({ statusCode: details.statusCode, url: details.url });
    });
    registerDesktopProtocol(webRoot, () => ({
      bridgeApiBase,
      bridgeToken,
      proxyToken,
      mergeCookieHeader: (header) => header,
      applySetCookieHeaders: () => undefined,
    }));

    mainWindow = new BrowserWindow({
      show: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    await mainWindow.loadURL("opengrove-desktop://ui/ui/");
  })
  .catch((error: unknown) => {
    console.error(error);
    app.exit(1);
  });

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}
