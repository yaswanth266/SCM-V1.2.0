import asyncio
import httpx
import json

token = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiI1IiwidXNlcm5hbWUiOiJzY20uc3VwcG9ydCIsImV4cCI6MTc5NDI5NjYxM30.bT1xI1wI7K-iX8tY00qYgJpXJ7kI4vO3Xf5y9I0"

async def main():
    async with httpx.AsyncClient() as client:
        try:
            # First, check what refreshStockForItems fetches
            resp = await client.get(
                "http://localhost:8000/api/v1/inventory/stock-balance?warehouse_id=18&item_id=1005&page_size=200",
                headers={"Authorization": f"Bearer {token}"}
            )
            data = resp.json()
            print(json.dumps(data, indent=2))
        except Exception as e:
            print(f"Error: {e}")

if __name__ == "__main__":
    asyncio.run(main())
