import index from "./index.html";

const server = Bun.serve({
  port: 1420,
  routes: {
    "/": index,
  },
  development: {
    hmr: true,
    console: true,
  },
});

console.log(`Dev server running at http://localhost:${server.port}`);
