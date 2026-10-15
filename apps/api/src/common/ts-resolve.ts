// The resolve step register.ts installs (see there): when a relative `.js`
// import from a file under packages/ does not resolve, try the `.ts` file.
// Anything else (node_modules, apps, bare specifiers) resolves unchanged.
import { fileURLToPath } from "node:url";

export interface ResolveContext {
  readonly parentURL?: string | undefined;
}

export function tsFallbackResolver<C extends ResolveContext, R>(
  packagesDir: string,
): (
  specifier: string,
  context: C,
  nextResolve: (specifier: string, context: C) => R,
) => R {
  return (specifier, context, nextResolve) => {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      const parent = context.parentURL;
      if (
        parent?.startsWith("file:") === true &&
        fileURLToPath(parent).startsWith(packagesDir) &&
        specifier.startsWith(".") &&
        specifier.endsWith(".js")
      ) {
        return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
      }
      throw error;
    }
  };
}
