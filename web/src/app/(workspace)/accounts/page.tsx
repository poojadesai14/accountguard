import { redirect } from "next/navigation";

// Account lookup lives in the review queue's search; old links keep their query.
export default async function Accounts({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const q = ((await searchParams).q ?? "").slice(0, 200);
  redirect(q ? `/?${new URLSearchParams({ q })}` : "/");
}
