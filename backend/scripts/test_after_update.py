
import asyncio
from unittest.mock import MagicMock, AsyncMock, patch
from app.database import AsyncSessionLocal
from app.api.v1.inventory import get_stock_balances

async def run_internal():
    async with AsyncSessionLocal() as db:
        # Mock current_user
        user = MagicMock()
        user.id = 15 # User 15 has access to WH 18
        
        with patch('app.utils.dependencies.user_is_managerial', new_callable=AsyncMock) as mock_managerial:
            mock_managerial.return_value = True
            
            response = await get_stock_balances(
                page=1,
                page_size=50,
                item_id="1005",
                warehouse_id=18,
                batch_id=None,
                category=None,
                batch=None,
                db=db,
                current_user=user
            )
            print("API Response for Item 1005, Warehouse 18:")
            import json
            print(json.dumps(response, indent=2, default=str))

if __name__ == "__main__":
    asyncio.run(run_internal())
