import globals from "globals";

export default [
    {
        files: ["**/*.js"],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: "script",
            globals: {
                ...globals.browser,
                ...globals.webextensions,
                chrome: "readonly",
                SecurityUtils: "readonly"
            }
        },
        rules: {
            "no-undef": "error",
            "no-unused-vars": ["warn", { "argsIgnorePattern": "^_", "caughtErrorsIgnorePattern": "^_|^e$|^error$" }],
            "no-redeclare": ["error", { "builtinGlobals": false }],
            "no-constant-condition": "warn",
            "no-debugger": "error"
        }
    },
    {
        files: ["test-dryrun.js"],
        languageOptions: {
            globals: {
                ...globals.node
            }
        }
    }
];
