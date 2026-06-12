declare module 'react-animals' {
  import type { ReactElement } from 'react';

  type AnimalProps = {
    /** Animal name, e.g. "axolotl". Random when omitted. */
    name?: string;
    /** One of: red | blue | yellow | purple | orange | green | teal. Random when omitted. */
    color?: string;
    /** CSS size, e.g. "40px". */
    size?: string;
    rounded?: boolean;
    square?: boolean;
    circle?: boolean;
    dance?: boolean;
  };

  export default function Animal(props: AnimalProps): ReactElement;
}
