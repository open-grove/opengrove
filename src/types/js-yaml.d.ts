declare module "js-yaml" {
  export function load(text: string): unknown;
  export function dump(value: unknown): string;
}
