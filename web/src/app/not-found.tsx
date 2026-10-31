import Link from "next/link";
export default function NotFound() {
  return (
    <main className="standalone-message">
      <p className="eyebrow">404 · NOT FOUND</p>
      <h1>We couldn’t find that record.</h1>
      <p>It may have been removed, or the link may be incomplete.</p>
      <Link href="/" className="button button-primary">
        Back to overview
      </Link>
    </main>
  );
}
