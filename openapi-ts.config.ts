import { defineConfig } from "@hey-api/openapi-ts";

export default defineConfig({
  input: "https://perps-api.vooi.io/swagger/json",
  output: "src/client",
  plugins: ["@hey-api/client-fetch"],
});
