// Blur of porn media (the blur_porn setting): a tap on a blurred item shows it, for this view only.
import "./nsfw.css";

export const blur = $state({ on: true });

/** The id to blur: the meme id when it is porn and blur is on, else false. */
export const blurId = (m: { id: string; porn: boolean }) => (blur.on && m.porn ? m.id : false);

/** Action: the node is blurred with an "18+" label until a click; that click only reveals it. */
export function nsfw(node: HTMLElement, id: string | false) {
  let shown = "";
  const sync = () => node.classList.toggle("nsfw", !!id && id !== shown);
  const reveal = (e: Event) => {
    if (!id || id === shown) return;
    e.preventDefault();
    e.stopPropagation();
    shown = id;
    sync();
  };
  node.addEventListener("click", reveal, true);
  sync();
  return {
    update: (v: string | false) => ((id = v), sync()),
    destroy: () => node.removeEventListener("click", reveal, true),
  };
}
