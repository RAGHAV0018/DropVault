// Stateless panel for generating and displaying a room code
export default function GeneratePanel({ code, onGenerate }) {
  return (
    <section className="flex flex-col gap-4">
      <div>
        <h2 className="text-sm font-medium text-stone-900">Start a drop</h2>
        <p className="mt-1 text-sm leading-relaxed text-stone-500">
          Generate a code and share it with the other person.
        </p>
      </div>

      <button
        type="button"
        onClick={onGenerate}
        className="rounded-xl bg-stone-950 px-4 py-3.5 text-sm font-medium text-stone-50 transition-colors hover:bg-stone-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-950"
      >
        Generate code
      </button>

      {code ? (
        <p
          className="rounded-xl border border-stone-200 bg-white px-4 py-5 text-center font-mono text-4xl tracking-[0.4em] text-stone-950 sm:text-5xl"
          aria-live="polite"
        >
          {code}
        </p>
      ) : null}
    </section>
  )
}
