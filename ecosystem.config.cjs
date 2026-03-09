module.exports = {
  apps: [
    {
      name: 'jubilee-recipes',
      script: 'server.js',
      cwd: 'C:/Users/samgr/jubilee-recipes',
      watch: false,
      restart_delay: 3000,
      max_restarts: 10,
      env: {
        NODE_ENV: 'production',
        PORT: 3001,
        SPOONACULAR_KEY: process.env.SPOONACULAR_KEY || '',
      },
    },
  ],
};
