import { delimiter, dirname, join } from "node:path";

const SAFE_ENVIRONMENT_NAMES = new Set([
  "DISPLAY",
  "HOME",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "NO_PROXY",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
  "SystemRoot",
  "TEMP",
  "TMP",
  "TMPDIR",
  "TZ",
  "USERPROFILE",
  "WAYLAND_DISPLAY",
  "XAUTHORITY",
  "XDG_CONFIG_HOME",
  "XDG_CURRENT_DESKTOP",
  "XDG_RUNTIME_DIR",
  "XDG_SESSION_TYPE",
]);

export function createDesktopGuiSmokeEnvironment(baseEnvironment, executable, overrides = {}) {
  const environment = createBaseEnvironment(baseEnvironment, executable, overrides);
  delete environment.ELECTRON_RUN_AS_NODE;
  return environment;
}

export function createDesktopSidecarSmokeEnvironment(baseEnvironment, executable, overrides = {}) {
  return createBaseEnvironment(baseEnvironment, executable, {
    ...overrides,
    ELECTRON_RUN_AS_NODE: "1",
  });
}

function createBaseEnvironment(baseEnvironment, executable, overrides) {
  const environment = Object.fromEntries(
    Object.entries(baseEnvironment).filter(([name, value]) => {
      if (value === undefined) return false;
      return SAFE_ENVIRONMENT_NAMES.has(name) || name.startsWith("LC_");
    }),
  );
  const systemRoot = environment.SystemRoot ?? "C:\\Windows";
  const systemPath =
    process.platform === "win32"
      ? [join(systemRoot, "System32"), systemRoot]
      : ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];
  environment.PATH = [dirname(executable), ...systemPath].join(delimiter);
  Object.assign(environment, overrides);
  delete environment.ELECTRON_RENDERER_URL;
  return environment;
}
