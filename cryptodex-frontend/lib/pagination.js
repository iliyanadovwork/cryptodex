import React from "react";
import classnames from "classnames";
import { usePagination, DOTS } from "./usePagination";
// import "./pagination.scss";

const Pagination = (props) => {
  const {
    onPageChange,
    totalCount,
    siblingCount = 1,
    currentPage,
    pageSize,
  } = props;

  const totalPageCount = Math.ceil(totalCount / pageSize);

  const paginationRange = usePagination({
    currentPage,
    totalPageCount,
    siblingCount,
    pageSize,
  });

  if (currentPage === 0 || paginationRange.length < 2) {
    return null;
  }

  const onNext = (e) => {
    e.preventDefault();
    if (currentPage !== totalPageCount) onPageChange(currentPage + 1);
  };

  const onPrevious = (e) => {
    e.preventDefault();
    if (currentPage !== 1) onPageChange(currentPage - 1);
  };

  let lastPage = paginationRange[paginationRange.length - 1];
  return (
    <nav className="table-pagination pb-3">
      <ul className="pagination justify-content-end">
        {currentPage != 1 ? (
          <li
            className={classnames("page-item", {
              disabled: currentPage === 1,
            })}
            onClick={onPrevious}
          >
            <a className="page-link" href="#" tabIndex="-1">
              {"Previous"}{" "}
            </a>
          </li>
        ) : (
          <></>
        )}
        {paginationRange.map((pageNumber, key) => {
          if (pageNumber === DOTS) {
            return (
              <li className="page-item dots" key={`dots-${key}`}>
                <a href="javascript:void(0);" className="page-link">
                  &#8230;
                </a>
              </li>
            );
          }
          return (
            <li
              className={classnames("page-item", {
                active: pageNumber === currentPage,
              })}
              key={key}
              onClick={(e) => {
                e.preventDefault();
                onPageChange(pageNumber);
              }}
            >
              <a className="page-link" href="#">
                {pageNumber}
              </a>
            </li>
          );
        })}
        {currentPage === totalPageCount ? (
          <></>
        ) : (
          <li
            className={classnames("page-item", {
              disabled: currentPage === totalPageCount,
            })}
            onClick={onNext}
          >
            <a className="page-link" href="#" tabIndex="-1">
              {"Next"}
            </a>
          </li>
        )}
      </ul>
    </nav>
  );
};

export default Pagination;
