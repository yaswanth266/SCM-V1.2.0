import asyncio
import httpx

async def main():
    async with httpx.AsyncClient() as client:
        # Use httpx to query the API directly
        # The user's backend is running on 8000 probably, let's assume standard local port
        try:
            resp = await client.get("http://localhost:8000/api/v1/inventory/stock-balance?warehouse_id=1&item_id=1005")
            data = resp.json()
            items = data.get("items", [])
            print(f"Got {len(items)} stock balance records")
            for item in items:
                print(f"Record: {item}")
        except Exception as e:
            print(f"Error: {e}")

if __name__ == "__main__":
    asyncio.run(main())
