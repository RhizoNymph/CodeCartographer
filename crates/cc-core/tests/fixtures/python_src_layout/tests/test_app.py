"""Test module importing the package from outside the source root."""

import mypkg.app
from mypkg.sub.helper import assist


def test_run() -> None:
    assert mypkg.app.run().startswith("assist:")
    assert assist("x") == "assist:x"
