// electron-builder 26 configuration. The server runtime (bundled Node + sources + production node_modules) ships as an
// extra resource outside asar so native modules and the server's own child processes run unchanged.
/** @type {import("electron-builder").Configuration} */
module.exports = {
  appId: "dev.vibread.app",
  productName: "ViBread",
  copyright: "Copyright © 2026 ViBread",
  directories: { output: "release", buildResources: "build" },
  files: ["dist/**/*", "static/**/*", "package.json", "!dist/**/*.map"],
  extraResources: [{ from: ".stage/runtime", to: "runtime", filter: ["**/*"] }],
  asar: true,
  // Nothing to rebuild: the app itself has no runtime dependencies (esbuild bundles them) and the server's native
  // modules belong to the bundled Node, not to Electron.
  npmRebuild: false,
  nodeGypRebuild: false,
  electronLanguages: ["en-US"],
  artifactName: "${productName}-${version}-${os}-${arch}.${ext}",
  mac: {
    category: "public.app-category.developer-tools",
    target: [
      { target: "dmg", arch: [process.arch === "arm64" ? "arm64" : "x64"] },
      { target: "zip", arch: [process.arch === "arm64" ? "arm64" : "x64"] },
    ],
    // Unsigned release: ad-hoc signature so Apple silicon runs it after "Open Anyway".
    identity: "-",
    hardenedRuntime: false,
    gatekeeperAssess: false,
    extendInfo: { NSLocalNetworkUsageDescription: "ViBread serves its web app to phones on your local network." },
  },
  dmg: { writeUpdateInfo: false },
  win: { target: [{ target: "nsis", arch: ["x64"] }], signAndEditExecutable: true },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    differentialPackage: false,
    shortcutName: "ViBread",
  },
  linux: {
    target: [
      { target: "AppImage", arch: ["x64"] },
      { target: "deb", arch: ["x64"] },
    ],
    category: "Development",
    synopsis: "AI-assisted Arduino prototyping with a built-in USB bench",
    maintainer: "ViBread <vibread@users.noreply.github.com>",
    executableName: "vibread",
    syncDesktopName: true,
  },
  // Static type2 runtime: needs only fusermount3 (no libfuse2 on Ubuntu 22.04+); AppRun adds --no-sandbox itself when
  // unprivileged user namespaces are blocked (Ubuntu 24.04+ AppArmor).
  toolsets: { appimage: "1.0.3" },
  publish: null,
};
