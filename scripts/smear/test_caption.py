"""caption.py 的判準。它同時決定兩件事,錯一邊都是把答案送給使用者:
  - 解析時一行進 caption / reveal_note,還是進作答前就顯示的病史
  - render 時一行留在步驟圖上,還是被遮掉

跑法:cd scripts/smear && python3 -m unittest test_caption
"""
import unittest
from caption import bare, detect_modalities, is_caption, split_caption


class TestIsCaption(unittest.TestCase):
    def test_bulleted_caption_is_caption(self):
        # ⚠️ 實際踩過:判日期前沒剝項目符號,整行掉進病史,而病史是作答前就顯示的。
        self.assertTrue(is_caption("• 2022/08/03 BM smear: suspect AML"))

    def test_both_modality_spellings(self):
        # 只認長寫法的話,APL 那一案整案標不到模態。
        self.assertTrue(is_caption("2025/04/09 Peripheral blood"))
        self.assertTrue(is_caption("2022/08/01 PB smear"))

    def test_dated_history_line_is_not_caption(self):
        # 有日期沒有模態 —— 那是病史,要留在病史裡。
        self.assertFalse(is_caption("• 2025/01/03 輔大H: palpable right neck mass"))

    def test_undated_line_is_not_caption(self):
        self.assertFalse(is_caption("Case 6: Acute promyelocytic leukemia with pancytopenia"))

    def test_pathology_line_is_not_caption(self):
        # `BM pathology:` 不是 `BM smear`,所以它被當內文遮掉 —— 那行正是答案。
        self.assertFalse(is_caption("2025/06/16 NTUH BM pathology: Aggressive B cell lymphoma"))


class TestSplitCaption(unittest.TestCase):
    def test_verdict_goes_right(self):
        self.assertEqual(split_caption("• 2022/08/03 BM smear: suspect AML"),
                         ("2022/08/03 BM smear", "suspect AML"))

    def test_fullwidth_colon(self):
        self.assertEqual(split_caption("2022/08/03 BM smear：suspect AML")[1], "suspect AML")

    def test_site_kept_on_left(self):
        left, verdict = split_caption("2025/01/20 Bone marrow (KFSYSCC): pending")
        self.assertEqual(left, "2025/01/20 Bone marrow (KFSYSCC)")
        self.assertEqual(verdict, "pending")

    def test_no_colon_no_verdict(self):
        self.assertEqual(split_caption("2023/08/05 Peripheral blood")[1], None)


class TestHelpers(unittest.TestCase):
    def test_multi_modality_in_order(self):
        self.assertEqual(detect_modalities("2025/01/20 Peripheral blood 2025/01/20 Bone marrow"), ["pb", "bm"])

    def test_bare_strips_bullets_only(self):
        self.assertEqual(bare("  • 2022/08/01 PB smear"), "2022/08/01 PB smear")


if __name__ == "__main__":
    unittest.main()
