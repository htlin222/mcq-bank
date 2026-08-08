import Animal from 'react-animals';
import { useIsEink } from '../lib/theme';

type Props = {
  email: string;
  avatarKey: string | null | undefined;
  name?: string | null;
  size?: number;
};

// Full lists from react-animals (build/index.js) — keep in sync if the
// package updates. Indexing locally keeps the pick deterministic.
const ANIMALS = [
  'alligator', 'anteater', 'armadillo', 'auroch', 'axolotl', 'badger', 'bat',
  'beaver', 'buffalo', 'camel', 'capybara', 'chameleon', 'cheetah',
  'chinchilla', 'chipmunk', 'chupacabra', 'cormorant', 'coyote', 'crow',
  'dingo', 'dinosaur', 'dolphin', 'duck', 'elephant', 'ferret', 'fox',
  'frog', 'giraffe', 'gopher', 'grizzly', 'hedgehog', 'hippo', 'hyena',
  'ibex', 'ifrit', 'iguana', 'jackal', 'kangaroo', 'koala', 'kraken',
  'lemur', 'leopard', 'liger', 'llama', 'manatee', 'mink', 'monkey',
  'moose', 'narwhal', 'orangutan', 'otter', 'panda', 'penguin', 'platypus',
  'pumpkin', 'python', 'quagga', 'rabbit', 'raccoon', 'rhino', 'sheep',
  'shrew', 'skunk', 'squirrel', 'tiger', 'turtle', 'walrus', 'wolf',
  'wolverine', 'wombat',
];
const ANIMAL_COLORS = ['red', 'blue', 'yellow', 'purple', 'orange', 'green', 'teal'];

// 電子紙模式的替身。react-animals 是 inline style 上色的彩色 SVG,styles.css
// 那層 class 選擇器完全構不到它 —— 這是少數必須改渲染、而不是覆寫樣式的地方。
// 四種框線讓「每個人有固定的長相」這件事在 1-bit 下仍然成立(顏色沒了,但
// 首字 + 框型的組合還在)。
const EINK_RINGS = [
  'border-2 border-solid',
  'border-[3px] border-double',
  'border-2 border-dashed',
  'border-2 border-dotted',
];

function hashEmail(email: string): number {
  let h = 0;
  for (let i = 0; i < email.length; i++) {
    h = (h * 31 + email.charCodeAt(i)) >>> 0;
  }
  return h;
}

export function Avatar({ email, avatarKey, name, size = 32 }: Props) {
  const style = { width: size, height: size };
  const eink = useIsEink();

  if (avatarKey) {
    return (
      <img
        src={`/img/${avatarKey}`}
        alt={name || email}
        className="rounded-full object-cover border border-ink-200 dark:border-ink-700"
        style={{ ...style, fontSize: size * 0.42 }}
      />
    );
  }

  // No uploaded photo — assign a Google-Docs-style anonymous animal.
  // "Random" but derived from the email hash, so each user keeps the same
  // animal/color across sessions and devices.
  const h = hashEmail(email);

  if (eink) {
    const initial = (name || email).trim().charAt(0).toUpperCase() || '?';
    return (
      <div
        className={`rounded-full bg-white text-black grid place-items-center font-bold shrink-0 select-none leading-none ${EINK_RINGS[h % EINK_RINGS.length]}`}
        style={{ ...style, fontSize: size * 0.45 }}
        title={name || email}
      >
        {initial}
      </div>
    );
  }

  const animal = ANIMALS[h % ANIMALS.length];
  const color = ANIMAL_COLORS[Math.floor(h / ANIMALS.length) % ANIMAL_COLORS.length];

  return (
    <div
      className="rounded-full overflow-hidden border border-ink-200 dark:border-ink-700 shrink-0 select-none"
      style={style}
      title={name || email}
    >
      <Animal name={animal} color={color} size={`${size}px`} />
    </div>
  );
}
