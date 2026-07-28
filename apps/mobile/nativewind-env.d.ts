/// <reference types="nativewind/types" />

// Metro turns the Tailwind entrypoint into a side-effect import; TypeScript
// needs to be told that a bare `.css` import is legal.
declare module "*.css";
