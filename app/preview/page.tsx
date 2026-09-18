
"use client";

import { useSearchParams } from "next/navigation";
export default function Preview() {

  const searchParams = useSearchParams();

    const worksParam = searchParams.get("works") || "";
  const selectedWorks = worksParam ? worksParam.split(",") : [];

  return (
    <main className="min-h-screen bg-stone-50 px-6 py-12 text-stone-800">
      <div className="mx-auto max-w-2xl">

        <h1 className="text-3xl font-bold">
          あなたの本
        </h1>

        <p className="mt-3 text-stone-500">
          編んだ作品を確認してください。
        </p>

       <div className="mt-10 rounded-2xl bg-white p-8 shadow-sm">

  {selectedWorks.map((title, index) => (
    <div key={title}>

      <h2 className="text-2xl font-bold">
        {title}
      </h2>

      {index < selectedWorks.length - 1 && (
        <div className="my-8 border-t border-stone-200" />
      )}

    </div>
  ))}

</div>
    </main>
  );