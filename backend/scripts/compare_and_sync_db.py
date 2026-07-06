import asyncio
import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.config import settings
from app.database import engine, Base
import app.models  # registers all models in Base.metadata

from sqlalchemy import inspect, text

def do_sync(connection):
    inspector = inspect(connection)
    db_tables = inspector.get_table_names()
    print(f"Database contains {len(db_tables)} tables.")
    print(f"SQLAlchemy metadata contains {len(Base.metadata.tables)} tables.\n")
    
    missing_tables = []
    missing_columns = []
    
    # 1. Check for missing tables
    for table_name, table in Base.metadata.tables.items():
        if table_name not in db_tables:
            missing_tables.append(table_name)
            
    if missing_tables:
        print(f"Found {len(missing_tables)} missing tables in DB. Creating them...")
        for table_name in missing_tables:
            table = Base.metadata.tables[table_name]
            try:
                print(f"  Creating table '{table_name}'...")
                # Use metadata to create this specific table
                Base.metadata.create_all(connection, tables=[table])
                print(f"    -> Table '{table_name}' created successfully.")
            except Exception as e:
                print(f"    -> Failed to create table '{table_name}': {e}")
    else:
        print("No missing tables found.")

    # Refresh table list
    inspector = inspect(connection)
    db_tables = inspector.get_table_names()

    # 2. Check for missing columns in existing tables
    for table_name, table in Base.metadata.tables.items():
        if table_name not in db_tables:
            continue
            
        db_cols = {col["name"]: col for col in inspector.get_columns(table_name)}
        for column in table.columns:
            if column.name not in db_cols:
                missing_columns.append((table_name, column))

    if missing_columns:
        print(f"\nFound {len(missing_columns)} missing columns in existing tables. Altering tables...")
        for table_name, column in missing_columns:
            try:
                type_str = str(column.type.compile(dialect=connection.dialect))
                # Map specific types to avoid mysql issues
                if "VARCHAR" in type_str.upper() and "(" not in type_str:
                    type_str = "VARCHAR(255)"
                
                null_str = "NULL" if column.nullable else "NOT NULL"
                
                print(f"  Altering table '{table_name}' to add column '{column.name}' ({type_str} {null_str})...")
                alter_query = f"ALTER TABLE `{table_name}` ADD COLUMN `{column.name}` {type_str} {null_str}"
                connection.execute(text(alter_query))
                print(f"    -> Column '{column.name}' added successfully.")
            except Exception as e:
                print(f"    -> Failed to add column '{column.name}' to '{table_name}': {e}")
    else:
        print("No missing columns found.")

async def main():
    print("=" * 80)
    print("DB SCHEMA TO MODELS ALIGNMENT & SYNC")
    print("=" * 80)
    
    async with engine.begin() as conn:
        await conn.run_sync(do_sync)
        
    print("\n" + "=" * 80)
    print("SYNC COMPLETE")
    print("=" * 80)

if __name__ == "__main__":
    asyncio.run(main())
