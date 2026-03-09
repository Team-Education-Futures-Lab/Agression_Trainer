import pytest


# Set asyncio mode for all async tests in this package.
# pytest-asyncio >= 0.21 requires this to be declared explicitly.
def pytest_configure(config):
    config.addinivalue_line(
        "markers", "asyncio: mark test as async"
    )