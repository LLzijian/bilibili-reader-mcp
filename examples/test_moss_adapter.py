"""Protocol parser checks; no model or third-party dependency required."""
import unittest
from moss_adapter import srt_segments


class SrtAdapterTests(unittest.TestCase):
    def test_bom_multiline_and_long_timestamps(self):
        result = srt_segments("\ufeff1\r\n00:00:01,250 --> 00:00:02,500\r\n第一行\r\n第二行\r\n\r\n2\r\n01:02:03,004 --> 01:02:04,000\r\n课程内容\r\n")
        self.assertEqual(result[0], {"type":"segment", "start":1.25, "end":2.5, "text":"第一行 第二行"})
        self.assertAlmostEqual(result[1]['start'], 3723.004)

    def test_reject_invalid_timing(self):
        with self.assertRaises(ValueError):
            srt_segments("1\nnot timing\nwords\n")


if __name__ == '__main__':
    unittest.main()
