export default function Preview() {
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

          <h2 className="text-2xl font-bold">
            こころ
          </h2>

          <p className="mt-2 text-stone-500">
            夏目漱石
          </p>

          <div className="my-8 border-t border-stone-200" />

          <h2 className="text-2xl font-bold">
            銀河鉄道の夜
          </h2>

          <p className="mt-2 text-stone-500">
            宮沢賢治
          </p>

        </div>

        <button className="mt-8 w-full rounded-xl bg-stone-800 px-6 py-4 text-lg font-medium text-white">
          この本を作る
        </button>

      </div>
    </main>
  );
}