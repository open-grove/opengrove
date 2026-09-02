import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createClient } from "@hey-api/openapi-ts";

const projectRoot = resolve(import.meta.dirname, "..");
const protocolEntry = join(projectRoot, "packages", "protocol", "dist", "compiled.js");
const openApiEntry = join(projectRoot, "packages", "protocol", "dist", "openapi.js");
const openApiPath = join(projectRoot, "packages", "protocol", "openapi.json");
const clientMapPath = join(projectRoot, "packages", "client", "client-map.json");
const clientOutputPath = join(projectRoot, "packages", "client", "src", "generated", "client.ts");
const heyApiOutputPath = join(projectRoot, "packages", "client", "src", "generated", "hey-api");
const clientTsConfigPath = join(projectRoot, "packages", "client", "tsconfig.json");
const biomeBinPath = join(projectRoot, "node_modules", "@biomejs", "biome", "bin", "biome");
const checkOnly = process.argv.includes("--check");

const [{ hostProtocol }, { hostProtocolToOpenApi }, clientMapSource] = await Promise.all([
  import(`${pathToFileURL(protocolEntry).href}?generator=${Date.now()}`),
  import(`${pathToFileURL(openApiEntry).href}?generator=${Date.now()}`),
  readFile(clientMapPath, "utf8"),
]);
const clientMap = JSON.parse(clientMapSource);
const openApiSource = await formatGeneratedSource(
  `${JSON.stringify(hostProtocolToOpenApi(hostProtocol), null, 2)}\n`,
  openApiPath,
);
const generatedClient = await formatGeneratedSource(renderClient(hostProtocol, clientMap), clientOutputPath);

if (checkOnly) {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "opengrove-host-client-"));
  const temporaryHeyApiOutput = join(temporaryRoot, "hey-api");
  try {
    await generateHeyApiClient(temporaryHeyApiOutput);
    const stale = [
      ...(await fileMismatch(openApiPath, openApiSource)),
      ...(await fileMismatch(clientOutputPath, generatedClient)),
      ...(await directoryMismatch(heyApiOutputPath, temporaryHeyApiOutput)),
    ];
    if (stale.length) {
      console.error(`Generated Host API artifacts are stale:\n${stale.map((path) => `- ${path}`).join("\n")}`);
      console.error("Run: npm run generate:host-client");
      process.exitCode = 1;
    } else {
      console.log("Generated OpenAPI and Host Client artifacts are current.");
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
} else {
  await Promise.all([
    mkdir(dirname(openApiPath), { recursive: true }),
    mkdir(dirname(clientOutputPath), { recursive: true }),
  ]);
  await Promise.all([writeFile(openApiPath, openApiSource), writeFile(clientOutputPath, generatedClient)]);
  await generateHeyApiClient(heyApiOutputPath);
  console.log(
    `Generated ${relativeProjectPath(openApiPath)} and ${relativeProjectPath(heyApiOutputPath)} from ${hostProtocol.operations.length} Host operation(s).`,
  );
}

async function generateHeyApiClient(outputPath) {
  await createClient({
    input: hostProtocolToOpenApi(hostProtocol),
    output: {
      path: outputPath,
      clean: true,
      tsConfigPath: clientTsConfigPath,
    },
    logs: { level: "silent", file: false },
    plugins: [
      { name: "@hey-api/typescript" },
      { name: "@hey-api/client-fetch", baseUrl: false, throwOnError: false },
      {
        name: "@hey-api/sdk",
        auth: false,
        client: "@hey-api/client-fetch",
        paramsStructure: "grouped",
        responseStyle: "fields",
        operations: {
          strategy: "single",
          containerName: "OpenGroveApi",
          nesting: "operationId",
          methods: "instance",
        },
      },
    ],
  });
  await run(process.execPath, [biomeBinPath, "format", "--write", outputPath]);
}

function renderClient(protocol, names) {
  const tree = createTreeNode();
  const usedNames = { groups: new Set(), resources: new Set(), operations: new Set() };
  for (const group of protocol.groups) {
    usedNames.groups.add(group.id);
    const groupPath = clientPath(names.groups?.[group.id] ?? group.id, `group ${group.id}`);
    for (const resource of group.resources) {
      const resourceId = `${group.id}.${resource.id}`;
      usedNames.resources.add(resourceId);
      const resourcePath = clientPath(names.resources?.[resourceId] ?? resource.id, `resource ${resourceId}`);
      for (const operation of resource.operations) {
        usedNames.operations.add(operation.id);
        const methodPath = clientPath(
          names.operations?.[operation.id] ?? operation.methodName,
          `operation ${operation.id}`,
        );
        const sections = {
          params: operation.input.params?.fields.map((field) => field.name),
          query: operation.input.query?.fields.map((field) => field.name),
          body: operation.input.body?.fields.map((field) => field.name),
        };
        const entry = {
          operation,
          sections,
          inputOptional: operation.input.optional,
          requestFunctionName: requestFunctionName(operation.id),
          sdkPath: [operation.groupId, operation.resourceId, ...operation.methodName.split(".")].map(
            typescriptPropertyName,
          ),
        };
        addOperation(tree, [...groupPath, ...resourcePath, ...methodPath], entry);
      }
    }
  }
  assertNoUnknownNames(names, usedNames);

  const requests = protocol.operations
    .map((operation) => findTreeOperation(tree, operation.id))
    .map(renderGeneratedRequest)
    .join("\n\n");
  const dispatchCases = protocol.operations
    .map((operation) => {
      const entry = findTreeOperation(tree, operation.id);
      const operationId = JSON.stringify(operation.id);
      const operationType = `(typeof hostOperationById)[${operationId}]`;
      return `      case ${operationId}:\n        return ${entry.requestFunctionName}(input as unknown as HostOperationCall<${operationType}>) as Promise<\n          HostOperationOutput<TOperation>\n        >;`;
    })
    .join("\n");
  const operationIds = protocol.operations.map((operation) => `  ${JSON.stringify(operation.id)},`).join("\n");

  return `// Generated by scripts/generate-host-client.mjs. Do not edit by hand.\nimport {\n  hostOperationById,\n  type HostOperation,\n  type HostOperationInput,\n  type HostOperationOutput,\n} from "#protocol";\nimport {\n  executeGeneratedHostOperation,\n  openGroveGeneratedRequestOptions,\n  type HostOperationCall,\n  type HostOperationRequest,\n  type OpenGroveGeneratedTransport,\n  type OpenGroveRequestOptions,\n} from "../transport.js";\n\nexport const openGroveClientOperationIds = [\n${operationIds}\n] as const;\n\nexport function bindOpenGroveClient(\n  fallbackRequest: HostOperationRequest,\n  transport: OpenGroveGeneratedTransport,\n) {\n${indent(requests, 2)}\n\n  const request: HostOperationRequest = <TOperation extends HostOperation>(\n    operation: TOperation,\n    input: HostOperationCall<TOperation>,\n  ): Promise<HostOperationOutput<TOperation>> => {\n    switch (operation.id) {\n${dispatchCases}\n      default:\n        return fallbackRequest(operation, input);\n    }\n  };\n\n  return {\n    request,\n${renderTreeChildren(tree, 4)}\n  };\n}\n\nexport type OpenGroveClient = ReturnType<typeof bindOpenGroveClient>;\n`;
}

function renderGeneratedRequest(entry) {
  const operationId = JSON.stringify(entry.operation.id);
  const operationType = `(typeof hostOperationById)[${operationId}]`;
  const requestParts = [
    ...(entry.sections.params ? ["path: validated.params,"] : []),
    ...(entry.sections.query ? ["query: validated.query,"] : []),
    ...(entry.sections.body ? ["body: validated.body,"] : []),
  ];
  return `const ${entry.requestFunctionName} = (\n  input: HostOperationCall<${operationType}>,\n): Promise<HostOperationOutput<${operationType}>> =>\n  executeGeneratedHostOperation(hostOperationById[${operationId}], input, async (validated) =>\n    transport.api.${entry.sdkPath.join(".")}({\n      ...(await openGroveGeneratedRequestOptions(transport, validated.signal)),\n${requestParts.map((line) => `      ${line}`).join("\n")}\n    }),\n  );`;
}

function createTreeNode() {
  return { children: new Map(), operation: undefined };
}

function addOperation(root, path, operation) {
  let node = root;
  for (const segment of path) {
    if (node.operation) throw new Error(`Client path ${path.join(".")} conflicts with an operation.`);
    let child = node.children.get(segment);
    if (!child) {
      child = createTreeNode();
      node.children.set(segment, child);
    }
    node = child;
  }
  if (node.operation || node.children.size) throw new Error(`Duplicate or conflicting Client path: ${path.join(".")}`);
  node.operation = operation;
}

function findTreeOperation(root, operationId) {
  const pending = [root];
  while (pending.length) {
    const node = pending.pop();
    if (node.operation?.operation.id === operationId) return node.operation;
    pending.push(...node.children.values());
  }
  throw new Error(`Generated Client tree is missing Host operation ${operationId}.`);
}

function renderTreeChildren(node, indentation) {
  return [...node.children.entries()]
    .map(([name, child]) => {
      const prefix = `${" ".repeat(indentation)}${propertyName(name)}: `;
      if (child.operation) return `${prefix}${renderOperation(child.operation, indentation)},`;
      return `${prefix}{\n${renderTreeChildren(child, indentation + 2)}\n${" ".repeat(indentation)}},`;
    })
    .join("\n");
}

function renderOperation(entry, indentation) {
  const operationId = JSON.stringify(entry.operation.id);
  const operationType = `(typeof hostOperationById)[${operationId}]`;
  const hasInput = Object.values(entry.sections).some((fields) => fields !== undefined);
  const parameters = [];
  if (hasInput) {
    parameters.push(`input: HostOperationInput<${operationType}>${entry.inputOptional ? " = {}" : ""},`);
  }
  parameters.push("options?: OpenGroveRequestOptions,");
  const requestSections = Object.entries(entry.sections)
    .filter(([, fields]) => fields !== undefined)
    .map(([name, fields]) => renderRequestSection(name, fields, indentation + 4));
  requestSections.push(`${" ".repeat(indentation + 4)}signal: options?.signal,`);
  return `(\n${parameters.map((line) => `${" ".repeat(indentation + 2)}${line}`).join("\n")}\n${" ".repeat(
    indentation,
  )}): Promise<HostOperationOutput<${operationType}>> =>\n${" ".repeat(indentation + 2)}request(hostOperationById[${operationId}], {\n${requestSections.join(
    "\n",
  )}\n${" ".repeat(indentation + 2)}})`;
}

function renderRequestSection(name, fields, indentation) {
  const properties = fields
    .map((field) => `${" ".repeat(indentation + 2)}${propertyName(field)}: input${propertyAccess(field)},`)
    .join("\n");
  return `${" ".repeat(indentation)}${name}: {\n${properties}\n${" ".repeat(indentation)}},`;
}

function assertNoUnknownNames(names, usedNames) {
  for (const section of ["groups", "resources", "operations"]) {
    for (const id of Object.keys(names[section] ?? {})) {
      if (!usedNames[section].has(id)) throw new Error(`Client map contains unknown ${section.slice(0, -1)} ${id}.`);
    }
  }
}

function clientPath(value, owner) {
  if (typeof value !== "string" || !value) throw new Error(`Missing Client name for ${owner}.`);
  const path = value.split(".");
  for (const segment of path) {
    if (!/^[$A-Z_a-z][$\w]*$/u.test(segment)) throw new Error(`Invalid Client name ${segment} for ${owner}.`);
  }
  return path;
}

function requestFunctionName(operationId) {
  return `request${operationId
    .split(/[.-]/u)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join("")}`;
}

function typescriptPropertyName(value) {
  const parts = value.split("-");
  return (
    parts[0] +
    parts
      .slice(1)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join("")
  );
}

function propertyName(value) {
  return /^[$A-Z_a-z][$\w]*$/u.test(value) ? value : JSON.stringify(value);
}

function propertyAccess(value) {
  return /^[$A-Z_a-z][$\w]*$/u.test(value) ? `.${value}` : `[${JSON.stringify(value)}]`;
}

function indent(value, size) {
  const prefix = " ".repeat(size);
  return value
    .split("\n")
    .map((line) => (line ? `${prefix}${line}` : line))
    .join("\n");
}

async function fileMismatch(path, expected) {
  const current = await readFile(path, "utf8").catch(() => undefined);
  return current === expected ? [] : [relativeProjectPath(path)];
}

async function directoryMismatch(currentRoot, expectedRoot) {
  const [current, expected] = await Promise.all([directorySnapshot(currentRoot), directorySnapshot(expectedRoot)]);
  const paths = new Set([...current.keys(), ...expected.keys()]);
  return [...paths]
    .sort()
    .filter((path) => current.get(path) !== expected.get(path))
    .map((path) => relativeProjectPath(join(currentRoot, path)));
}

async function directorySnapshot(root, current = "") {
  const result = new Map();
  const entries = await readdir(join(root, current), { withFileTypes: true }).catch(() => []);
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const relativePath = join(current, entry.name);
    if (entry.isDirectory()) {
      const nested = await directorySnapshot(root, relativePath);
      for (const [path, source] of nested) result.set(path, source);
    } else if (entry.isFile()) {
      result.set(relativePath, await readFile(join(root, relativePath), "utf8"));
    }
  }
  return result;
}

async function run(command, args) {
  await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: projectRoot, stdio: "ignore" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`Command failed (${signal ? `signal ${signal}` : `exit ${code}`}): ${args.join(" ")}`));
    });
  });
}

async function formatGeneratedSource(source, filePath) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [biomeBinPath, "format", "--stdin-file-path", filePath], {
      cwd: projectRoot,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    let errorOutput = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      errorOutput += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePromise(output);
      else {
        reject(new Error(`Formatter failed (${signal ? `signal ${signal}` : `exit ${code}`}): ${errorOutput.trim()}`));
      }
    });
    child.stdin.end(source);
  });
}

function relativeProjectPath(path) {
  return relative(projectRoot, path);
}
