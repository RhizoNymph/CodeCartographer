"""Application module exercising src-layout absolute imports."""

import os

import mypkg.mod
from mypkg.sub.helper import assist
from mypkg.build.real import build_thing
from . import package_name


def run() -> str:
    thing = mypkg.mod.Thing()
    return assist(thing.label()) + build_thing() + package_name() + os.sep
