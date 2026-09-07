/// <reference types="vite/client" />

declare const __OPENGROVE_DEV_FIXTURE_ACCOUNTS__: boolean;

declare module "*.module.css" {
  const classes: Record<string, string>;
  export default classes;
}
