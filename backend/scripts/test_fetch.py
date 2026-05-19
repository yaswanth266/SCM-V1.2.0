import asyncio
import httpx

async def main():
    async with httpx.AsyncClient() as client:
        try:
            # Emulate fetchItemStockDetails
            resp = await client.get("http://localhost:8000/api/v1/inventory/stock-balance?warehouse_id=18&item_id=1005&page_size=200")
            print("Status:", resp.status_code)
            data = resp.json()
            items = data.get("items", [])
            print(f"Got {len(items)} stock balance records")
            for item in items:
                print(f"Batch ID: {item.get('batch_id')}, Batch Number: {item.get('batch_number')}")
        except Exception as e:
            print(f"Error: {e}")

if __name__ == "__main__":
    asyncio.run(main())
