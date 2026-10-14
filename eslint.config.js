import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/node_modules/", ".tsbuild/", "**/dist/"] },
  ...tseslint.configs.strict,
);
