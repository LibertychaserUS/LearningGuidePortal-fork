import { notFound } from "next/navigation";
import WhiteboardDemo from "@/components/portal/WhiteboardDemo";

// Prototype playground, local `next dev` only: never served by a build.
// `?as=<id>` shows one person's screen only, so separate browsers can join.
export default async function WhiteboardDemoPage({ searchParams }: { searchParams: Promise<{ as?: string }> }) {
  if (process.env.NODE_ENV !== "development") notFound();
  const { as } = await searchParams;
  return <WhiteboardDemo only={typeof as === "string" ? as : undefined} />;
}
