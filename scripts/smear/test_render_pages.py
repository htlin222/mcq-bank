import unittest
from render_pages import trim_box


class TestTrimBox(unittest.TestCase):
    def test_all_white_returns_none(self):
        # 全白的頁不該裁成 0×0 —— 回 None,呼叫端保留原圖
        self.assertIsNone(trim_box([[255] * 10 for _ in range(10)], 250))

    def test_finds_content_bounds(self):
        px = [[255] * 10 for _ in range(10)]
        px[3][4] = 0
        px[6][7] = 0
        self.assertEqual(trim_box(px, 250), (4, 3, 8, 7))  # l, t, r, b (exclusive)

    def test_pads_by_margin(self):
        px = [[255] * 10 for _ in range(10)]
        px[5][5] = 0
        self.assertEqual(trim_box(px, 250, margin=2), (3, 3, 8, 8))

    def test_margin_clamped_to_image(self):
        px = [[255] * 4 for _ in range(4)]
        px[0][0] = 0
        self.assertEqual(trim_box(px, 250, margin=3), (0, 0, 4, 4))


if __name__ == "__main__":
    unittest.main()
