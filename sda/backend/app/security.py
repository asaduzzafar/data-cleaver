"""Who is using the app.

One person on their own machine, so the user is whoever the config names --
recorded as the author of loads and saves, never checked against anything.
"""

from dataclasses import dataclass

from fastapi import Request


@dataclass(frozen=True)
class User:
    username: str


def current_user(request: Request) -> User:
    return User(request.app.state.config.dev_user)
