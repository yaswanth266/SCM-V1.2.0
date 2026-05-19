
import asyncio
from httpx import AsyncClient
from app.main import app

async def test_qi_list():
    async with AsyncClient(app=app, base_url="http://test") as ac:
        # We need a token, but let's see if it fails with 500 or 401 first
        # Actually, if it's a 500, it usually happens after auth
        response = await ac.get("/api/v1/warehouse/qi")
        print(f"Status: {response.status_code}")
        if response.status_code == 500:
            print(response.text)

if __name__ == "__main__":
    asyncio.run(test_qi_list())
