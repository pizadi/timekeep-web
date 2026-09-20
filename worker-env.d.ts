declare const __BUILD_SHA__: string;
// app semver, injected at build time (vite define for the SPA from package.json;
// `wrangler deploy --define __APP_VERSION__:$npm_package_version` for the worker)
declare const __APP_VERSION__: string;
declare module '*?raw' {
  const content: string;
  export default content;
}
declare module '*.txt' {
  const content: string;
  export default content;
}
