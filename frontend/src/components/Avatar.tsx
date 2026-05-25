type Props = {
  email: string;
  avatarKey: string | null | undefined;
  name?: string | null;
  size?: number;
};

// Deterministic color from email so people without uploaded avatars
// still feel distinct.
function colorFor(email: string): string {
  let h = 0;
  for (let i = 0; i < email.length; i++) {
    h = (h * 31 + email.charCodeAt(i)) >>> 0;
  }
  const palette = ['#a8442a', '#3f3729', '#5d5240', '#8a7d65', '#7a2f1d', '#cb6845', '#2a2419'];
  return palette[h % palette.length];
}

export function Avatar({ email, avatarKey, name, size = 32 }: Props) {
  const initial = (name || email).trim().charAt(0).toUpperCase();
  const style = { width: size, height: size, fontSize: size * 0.42 };

  if (avatarKey) {
    return (
      <img
        src={`/img/${avatarKey}`}
        alt={name || email}
        className="rounded-full object-cover border border-ink-200 dark:border-ink-700"
        style={style}
      />
    );
  }

  return (
    <div
      className="rounded-full flex items-center justify-center text-white font-semibold select-none"
      style={{ ...style, backgroundColor: colorFor(email) }}
      title={name || email}
    >
      {initial}
    </div>
  );
}
