export default function CreatePage() {
  return (
    <main className="min-h-screen bg-stone-50 px-6 py-16 text-stone-800">
      <div className="mx-auto max-w-3xl">

        <p className="text-sm tracking-widest text-stone-500">
          編む本
        </p>

        <h1 className="mt-4 text-4xl font-bold">
          本を編み始める
        </h1>

        <p className="mt-6 text-lg leading-8 text-stone-600">
          ここから、あなたの一冊をつくっていきます。
        </p>

        <div className="mt-12 rounded-2xl bg-white p-8 shadow-sm">
          <h2 className="text-2xl font-bold">
            まずは作品を選びましょう
          </h2>

          <p className="mt-4 text-stone-600">
            読みたい作品を選んで、自分だけの本に編んでいきます。
          </p>
        </div>

      </div>
    </main>
  );
}