import os

import asyncpg


def database_url() -> str:
    value = os.getenv("DATABASE_URL", "").strip()
    if not value:
        raise RuntimeError("DATABASE_URL must be configured")
    return value


def account_key() -> str:
    value = os.getenv("SMARTENANCE_ACCOUNT_KEY", "").strip()
    if not value:
        raise RuntimeError("SMARTENANCE_ACCOUNT_KEY must be configured")
    return value


async def open_pool() -> asyncpg.Pool:
    return await asyncpg.create_pool(
        dsn=database_url(),
        min_size=1,
        max_size=int(os.getenv("DATABASE_POOL_SIZE", "5")),
        command_timeout=30,
        server_settings={"application_name": "smartenance-agent"},
    )
