import Link from "next/link";
export default function Home() {
  return (
    <main className="min-h-screen bg-stone-50 text-stone-800">

      {/* ヘッダー */}
      <header className="flex items-center justify-between px-8 py-6">
        <h1 className="text-2xl font-bold">
          📚 編む本
        </h1>

        <span className="text-sm text-stone-500">
          あなただけの一冊を
        </span>
      </header>

      {/* メインビジュアル */}
      <section className="flex min-h-[70vh] flex-col items-center justify-center px-6 text-center">

        <p className="mb-4 text-sm tracking-widest text-stone-500">
          世界に一冊
        </p>

        <h2 className="text-5xl font-bold leading-tight md:text-6xl">
          あなただけの本を。
        </h2>

        <p className="mt-8 max-w-xl text-lg leading-8 text-stone-600">
          好きな物語を選び、
          <br />
          自分だけの順番で編んでいく。
          <br />
          世界に一冊しかない本をつくるサービスです。
        </p>

        <Link
  href="/create"
  className="mt-10 rounded-xl bg-stone-800 px-8 py-4 text-lg font-medium text-white transition hover:bg-stone-700"
>
  本を編み始める
</Link>

      </section>

      {/* 編む本とは */}
      <section className="border-t border-stone-200 bg-white px-6 py-20">
        <div className="mx-auto max-w-3xl text-center">

          <p className="text-sm tracking-widest text-stone-500">
            ABOUT
          </p>

          <h2 className="mt-3 text-3xl font-bold">
            「編む本」とは？
          </h2>

          <p className="mt-8 text-lg leading-9 text-stone-600">
            本は、誰かが決めた順番で読むもの。
            <br />
            でも、ときには自分だけの順番で
            <br />
            物語を楽しんでもいい。
          </p>

        </div>
      </section>

      {/* 3ステップ */}
      <section className="px-6 py-20">

        <div className="mx-auto max-w-4xl">

          <h2 className="text-center text-3xl font-bold">
            本を編む、3つのステップ
          </h2>

          <div className="mt-12 grid gap-8 md:grid-cols-3">

            <div className="rounded-2xl bg-white p-8 shadow-sm">
              <div className="text-3xl">①</div>
              <h3 className="mt-4 text-xl font-bold">
                作品を選ぶ
              </h3>
              <p className="mt-3 leading-7 text-stone-600">
                読みたい作品を選びます。
              </p>
            </div>

            <div className="rounded-2xl bg-white p-8 shadow-sm">
              <div className="text-3xl">②</div>
              <h3 className="mt-4 text-xl font-bold">
                本を編む
              </h3>
              <p className="mt-3 leading-7 text-stone-600">
                好きな作品を好きな順番で組み合わせます。
              </p>
            </div>

            <div className="rounded-2xl bg-white p-8 shadow-sm">
              <div className="text-3xl">③</div>
              <h3 className="mt-4 text-xl font-bold">
                一冊の本にする
              </h3>
              <p className="mt-3 leading-7 text-stone-600">
                あなただけの一冊として形にします。
              </p>
            </div>

          </div>

        </div>
      </section>

      {/* フッター */}
      <footer className="border-t border-stone-200 px-6 py-8 text-center text-sm text-stone-500">
        © 2026 編む本
      </footer>

    </main>
  );
}