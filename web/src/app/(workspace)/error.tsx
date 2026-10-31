"use client";

import { ApiError } from "@/components/ui";
export default function ErrorPage({ reset }: { reset: () => void }) {
  return (
    <>
      <h1>Something interrupted this view.</h1>
      <ApiError message="Please try loading the page again." />
      <button className="button button-primary" onClick={reset}>
        Try again
      </button>
    </>
  );
}
