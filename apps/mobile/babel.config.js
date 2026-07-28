module.exports = function (api) {
  api.cache(true);
  return {
    presets: [
      // `jsxImportSource: "nativewind"` is what makes `className` work on RN
      // components; without it every className is silently ignored.
      ["babel-preset-expo", { jsxImportSource: "nativewind" }],
      "nativewind/babel",
    ],
  };
};
