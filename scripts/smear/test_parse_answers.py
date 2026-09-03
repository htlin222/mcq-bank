import unittest
from parse_answers import parse_answer_key, DECK_MAP


class TestParseAnswerKey(unittest.TestCase):
    def test_plain_line(self):
        rows = parse_answer_key("1. AMoL\n2. MM\n")
        self.assertEqual(rows[0], {"n": 1, "raw": "AMoL", "main": "AMoL",
                                   "alts": [], "half": []})

    def test_parenthetical_alternates(self):
        rows = parse_answer_key("3. Pronormoblast (proerythroblast)\n")
        self.assertEqual(rows[0]["main"], "Pronormoblast")
        self.assertEqual(rows[0]["alts"], ["proerythroblast"])

    def test_half_marker_is_not_an_alternate(self):
        # 「半對」是分級,不是同義詞 —— 混進 alts 會讓 Plasma cell 拿滿分
        rows = parse_answer_key("9. Plasmoblast (Plasma cell 半對)\n")
        self.assertEqual(rows[0]["main"], "Plasmoblast")
        self.assertEqual(rows[0]["alts"], [])
        self.assertEqual(rows[0]["half"], ["Plasma cell"])

    def test_comma_inside_parens_splits(self):
        rows = parse_answer_key("42. MAHA (Hemolysis, DIC)\n")
        self.assertEqual(rows[0]["alts"], ["Hemolysis", "DIC"])

    def test_comma_outside_parens_does_not_split(self):
        # 「AML, M4」是一個答案,不是兩個
        rows = parse_answer_key("43. AML, M4\n")
        self.assertEqual(rows[0]["main"], "AML, M4")

    def test_ignores_header_line(self):
        rows = parse_answer_key("[Test 1 ANS]\n\n1. AMoL\n")
        self.assertEqual(len(rows), 1)


if __name__ == "__main__":
    unittest.main()
