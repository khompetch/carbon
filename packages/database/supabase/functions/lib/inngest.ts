import { Inngest } from "jsr:@inngest/sdk@3.45.1";

const inngest = new Inngest({ id: "carbon" });

export async function sendInngestEvent(
  name: string,
  data: Record<string, unknown>,
) {
  await inngest.send({ name, data });
}

export async function sendInngestEvents(
  events: Array<{ name: string; data: Record<string, unknown> }>,
) {
  await inngest.send(events);
}
