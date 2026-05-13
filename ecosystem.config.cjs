module.exports = {
  apps: [
    {
      name: "philchat",
      cwd: __dirname,
      script: "server/src/index.js",
      env: {
        NODE_ENV: "production",
        PORT: "8791",
        APP_BASE_PATH: "/philchat",
      },
    },
  ],
};
