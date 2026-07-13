#!/usr/bin/env node
import { serve } from "@hono/node-server";
import server from "./index.js";

serve(server, (info) => {
  console.log(`memstack server listening on http://localhost:${info.port}`);
});
