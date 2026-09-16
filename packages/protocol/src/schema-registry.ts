import { z } from "zod";

// Names affect generated documents only; runtime validation and CLI schemas stay unchanged.
export const hostSchemaRegistry = z.registry<{ id: string }>();
