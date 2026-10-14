import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/node_modules/", ".tsbuild/", "**/dist/", "**/test-results/", "**/playwright-report/"] },
  ...tseslint.configs.strict,
  {
    files: ["packages/web/src/**/*.tsx", "packages/web/src/**/*.ts"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // EDID text is untrusted (SPEC.md section 13): never insert it as HTML.
      "no-restricted-syntax": [
        "error",
        { selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']", message: "Never insert HTML; EDID text is untrusted." },
        { selector: "MemberExpression[property.name=/^(innerHTML|outerHTML)$/]", message: "Never insert HTML; EDID text is untrusted." },
        { selector: "CallExpression[callee.property.name='insertAdjacentHTML']", message: "Never insert HTML; EDID text is untrusted." },
      ],
    },
  },
);
