import { z } from "zod";

export const PortRequestSchema = z.object({
  kind: z.literal("request"),
  id: z.string(),
  method: z.string(),
  args: z.array(z.unknown()),
});
export type PortRequest = z.infer<typeof PortRequestSchema>;

export const PortResponseSchema = z.object({
  kind: z.literal("response"),
  id: z.string(),
  ok: z.boolean(),
  result: z.unknown().optional(),
  error: z
    .object({
      message: z.string(),
      stack: z.string().optional(),
    })
    .optional(),
});
export type PortResponse = z.infer<typeof PortResponseSchema>;

export const PortBroadcastSchema = z.object({
  kind: z.literal("broadcast"),
  event: z.enum([
    "wallet-update",
    "authorization-request",
    "proof-debug-export-request",
    "vault-locked",
    "vault-unlocked",
  ]),
  payload: z.unknown(),
});
export type PortBroadcast = z.infer<typeof PortBroadcastSchema>;

export const PortMessageSchema = z.discriminatedUnion("kind", [
  PortRequestSchema,
  PortResponseSchema,
  PortBroadcastSchema,
]);
export type PortMessage = z.infer<typeof PortMessageSchema>;

export const OFFSCREEN_PORT_NAME = "offscreen-wallet";
export const KEEP_ALIVE_PORT_NAME = "keep-alive";
