import unittest
from typing import Any
from unittest import mock

from services.account_service import AccountService


class MemoryStorage:
    def __init__(self, accounts: list[dict[str, Any]] | None = None) -> None:
        self.accounts = list(accounts or [])

    def load_accounts(self) -> list[dict[str, Any]]:
        return list(self.accounts)

    def save_accounts(self, accounts: list[dict[str, Any]]) -> None:
        self.accounts = list(accounts)

    def load_auth_keys(self) -> list[dict[str, Any]]:
        return []

    def save_auth_keys(self, auth_keys: list[dict[str, Any]]) -> None:
        pass


def account(token: str, created_at: str) -> dict[str, Any]:
    return {"access_token": token, "created_at": created_at}


class AccountOrderingTests(unittest.TestCase):
    def test_list_accounts_sorts_by_created_at_descending(self) -> None:
        service = AccountService(
            MemoryStorage(
                [
                    account("oldest", "2026-10-01 08:00:00"),
                    account("newest", "2026-10-20T09:30:00Z"),
                    account("middle", "2026-10-10T10:00:00+08:00"),
                ]
            )
        )

        self.assertEqual(
            [item["access_token"] for item in service.list_accounts()],
            ["newest", "middle", "oldest"],
        )

    def test_add_accounts_response_lists_new_account_first(self) -> None:
        service = AccountService(MemoryStorage([account("old", "2026-10-01 08:00:00")]))

        with mock.patch.object(AccountService, "_save_cumulative_total"):
            result = service.add_accounts(["fresh"])

        self.assertEqual([item["access_token"] for item in result["items"]], ["fresh", "old"])

    def test_delete_accounts_response_keeps_created_at_order(self) -> None:
        service = AccountService(
            MemoryStorage(
                [
                    account("oldest", "2026-10-01 08:00:00"),
                    account("newest", "2026-10-20 09:30:00"),
                ]
            )
        )

        result = service.delete_accounts(["nope"])

        self.assertEqual([item["access_token"] for item in result["items"]], ["newest", "oldest"])


if __name__ == "__main__":
    unittest.main()
