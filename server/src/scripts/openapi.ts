import { writeFileSync } from "node:fs";
import { OPENAPI_FILE, buildOpenApiDocument, serializeOpenApiDocument } from "../openapi.js";

writeFileSync(OPENAPI_FILE, serializeOpenApiDocument(buildOpenApiDocument()));
console.log(`OpenAPI document written to ${OPENAPI_FILE}`);
