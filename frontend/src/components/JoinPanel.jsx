// Controlled form for entering a 4-digit room code
export default function JoinPanel({ value, onChange, onSubmit }) {
  return (
    <section className="flex flex-col gap-4">
      <div>
        <h2 className="text-sm font-medium text-stone-900">Join a drop</h2>
        <p className="mt-1 text-sm leading-relaxed text-stone-500">
          Enter the 4-digit code you were given.
        </p>
      </div>

      <form onSubmit={onSubmit} className="flex flex-col gap-3 sm:flex-row">
        <label className="sr-only" htmlFor="join-code">
          4-digit code
        </label>
        <input
          id="join-code"
          name="code"
          inputMode="numeric"
          autoComplete="off"
          maxLength={4}
          placeholder="0000"
          value={value}
          onChange={onChange}
          className="w-full rounded-xl border border-stone-300 bg-white px-4 py-3.5 text-center font-mono text-lg tracking-[0.4em] text-stone-950 outline-none placeholder:tracking-[0.4em] placeholder:text-stone-300 focus:border-stone-950 sm:flex-1 sm:text-left"
        />
        <button
          type="submit"
          className="rounded-xl border border-stone-950 px-4 py-3.5 text-sm font-medium text-stone-950 transition-colors hover:bg-stone-950 hover:text-stone-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-950"
        >
          Join
        </button>
      </form>
    </section>
  )
}
