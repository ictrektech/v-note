import unittest
from check_appstore_version import check


class VersionGuardTest(unittest.TestCase):
    def test_new_application_and_newer_version(self):
        check({'code': 20207}, '0.0.7')
        check({'code': 0, 'data': {'id': 'com.ictrek.v-note', 'versions': ['0.0.6']}}, '0.0.7')

    def test_refuses_overwrite_downgrade_and_unrecognized_responses(self):
        for record, version in [
            ({'code': 0, 'data': {'id': 'com.ictrek.v-note', 'versions': ['0.0.7']}}, '0.0.7'),
            ({'code': 0, 'data': {'id': 'com.ictrek.v-note', 'versions': ['0.1.0']}}, '0.0.7'),
            ({'code': 0, 'data': {'id': 'com.ictrek.v-note', 'versions': ['broken']}}, '0.0.7'),
            ({'code': 500}, '0.0.7'),
        ]:
            with self.subTest(record=record), self.assertRaises(ValueError):
                check(record, version)


if __name__ == '__main__':
    unittest.main()
