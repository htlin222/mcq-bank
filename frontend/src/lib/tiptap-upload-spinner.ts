import { Extension, type Editor } from '@tiptap/react';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

// 貼上/拖入圖片時,在游標上放一顆轉圈,直到圖片上傳完成。
//
// 用 ProseMirror 的 widget decoration,不用絕對定位的浮層:decoration 的位置
// 跟著 transaction 一起 map,所以編輯器捲動、使用者繼續打字,它都還黏在原本
// 那個插入點上。浮層要自己算座標(coordsAtPos 給的是視窗座標,而編輯區是
// 自己捲的容器),而且捲一下就對不上了 —— 那正是「看起來像壞掉」的樣子。
//
// decoration 不是文件的一部分,所以它不可能被存進 content_json;上傳途中
// 自動存檔存到的仍是乾淨的文件。

type Meta = { show: true; pos: number } | { show: false };

const key = new PluginKey<DecorationSet>('uploadSpinner');

// lucide-react `LoaderCircle` 的 path 與預設屬性,逐字照抄
// (node_modules/lucide-react/dist/esm/icons/loader-circle.mjs)。widget
// decoration 拿到的是原生 DOM,掛不上 React 元件 —— 為此把 react-dom/server
// 拉進 bundle 不划算。lucide 換圖示時這裡要跟著換。
function spinnerDom(): HTMLElement {
  const span = document.createElement('span');
  span.className =
    'upload-spinner inline-flex align-middle mx-1 text-accent dark:text-accent-light';
  span.setAttribute('role', 'img');
  span.setAttribute('aria-label', '圖片上傳中');
  span.setAttribute('contenteditable', 'false');
  span.innerHTML =
    '<svg class="upload-spinner-icon" xmlns="http://www.w3.org/2000/svg"' +
    ' width="16" height="16" viewBox="0 0 24 24" fill="none"' +
    ' stroke="currentColor" stroke-width="2" stroke-linecap="round"' +
    ' stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>';
  return span;
}

export const UploadSpinner = Extension.create({
  name: 'uploadSpinner',
  addProseMirrorPlugins() {
    return [
      new Plugin<DecorationSet>({
        key,
        state: {
          init: () => DecorationSet.empty,
          apply(tr, set) {
            const meta = tr.getMeta(key) as Meta | undefined;
            if (meta?.show === true) {
              return DecorationSet.create(tr.doc, [
                // side: 1 —— 畫在游標之後,插入點本身不被推開。
                Decoration.widget(meta.pos, spinnerDom, {
                  side: 1,
                  key: 'upload-spinner',
                }),
              ]);
            }
            if (meta?.show === false) return DecorationSet.empty;
            // 沒有 meta 就跟著文件走:使用者在上傳途中繼續打字時,轉圈不會
            // 留在原本那個字元位置上。
            return set.map(tr.mapping, tr.doc);
          },
        },
        props: {
          decorations: (state) => key.getState(state),
        },
      }),
    ];
  },
});

/** 在目前游標處放一顆轉圈(重複呼叫會把它移到最新的游標處)。 */
export function showUploadSpinner(editor: Editor | null) {
  if (!editor) return;
  const meta: Meta = { show: true, pos: editor.state.selection.from };
  editor.view.dispatch(editor.state.tr.setMeta(key, meta));
}

export function hideUploadSpinner(editor: Editor | null) {
  if (!editor) return;
  const meta: Meta = { show: false };
  editor.view.dispatch(editor.state.tr.setMeta(key, meta));
}
